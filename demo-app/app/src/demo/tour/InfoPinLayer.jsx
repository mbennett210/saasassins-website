import { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { pointsForPath } from './infoPoints';
import InfoBubble from './InfoBubble';
import '../demo.css';

// Non-blocking, demo-only layer of in-content "i" info pins. For the current
// route it positions a gently-pinging pin just after each matching info point's
// header TITLE text (measured via a Range so the pin sits beside the words, not
// at the header block's far-right edge), re-measured on route change / scroll /
// resize. Clicking a pin opens an InfoBubble beside it and quiets that pin for
// good (per-key memory in localStorage).
//
// Mounted inside <main> in AppLayout behind IS_DEMO. The page stays fully usable;
// only the pins + the open bubble are interactive.

const SEEN_KEY = 'pp.demo.pinSeen.v1';
const PIN = 24; // px — keep in sync with .pp-pin width in demo.css

const loadSeen = () => {
  try { return new Set(JSON.parse(window.localStorage.getItem(SEEN_KEY)) || []); } catch { return new Set(); }
};
const markSeen = (key) => {
  try {
    const s = loadSeen();
    s.add(key);
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...s]));
  } catch { /* ignore */ }
};

// Bounding rect of an element's text content (via a Range) so the pin can sit just
// after the words; falls back to the element box if the range can't be measured.
const textRect = (el) => {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return r;
  } catch { /* fall through */ }
  return el.getBoundingClientRect();
};

export default function InfoPinLayer() {
  const { pathname } = useLocation();
  const [pins, setPins] = useState([]);
  const [openKey, setOpenKey] = useState(null);
  const [seen, setSeen] = useState(loadSeen);

  const measure = useCallback(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const next = [];
    pointsForPath(pathname).forEach((p) => {
      const el = document.querySelector(p.selector);
      if (!el) return;
      const r = textRect(el);
      const visible = r.width > 0 && r.height > 0 && r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
      if (!visible) return;
      // Pin just after the title text, vertically centered on it; clamped on-screen.
      const top = Math.max(8, Math.round(r.top + (r.height - PIN) / 2));
      const left = Math.round(Math.min(r.right + 8, vw - PIN - 8));
      next.push({ ...p, top, left, pinRect: { top, left, right: left + PIN, bottom: top + PIN } });
    });
    setPins(next);
  }, [pathname]);

  useEffect(() => {
    const raf = requestAnimationFrame(measure);
    const t = setTimeout(measure, 180); // let the freshly-routed page lay out
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  // Close any open bubble when the route changes.
  useEffect(() => { setOpenKey(null); }, [pathname]);

  const open = (key) => {
    setOpenKey(key);
    if (!seen.has(key)) {
      markSeen(key);
      setSeen((s) => new Set(s).add(key));
    }
  };

  if (!pins.length) return null;
  const openPin = pins.find((p) => p.key === openKey);

  return (
    <div className="pp-pin-layer">
      {pins.map((p, i) => (
        <button
          key={p.key}
          type="button"
          className={`pp-pin${seen.has(p.key) ? '' : ' is-pinging'}`}
          style={{ top: p.top, left: p.left, animationDelay: `${i * 0.9}s` }}
          onClick={(e) => { e.stopPropagation(); open(p.key); }}
          aria-label={`About ${p.title}`}
          title={p.title}
        >
          i
        </button>
      ))}
      {openPin && (
        <InfoBubble
          pinRect={openPin.pinRect}
          side={openPin.side}
          title={openPin.title}
          body={openPin.body}
          onClose={() => setOpenKey(null)}
        />
      )}
    </div>
  );
}
