import { useEffect, useState, useCallback } from 'react';
import { useTour } from './tourContext';
import '../demo.css';

// Spotlight overlay for the guided tour. Dims the page (a box-shadow "hole" over
// the current target, or a full dim for centered intro steps + off-screen
// targets), blocks page clicks so navigation stays on the rails, and shows a
// tooltip card with Back/Next/Skip + progress. Re-measures on step change,
// resize, and scroll. Viewport metrics are read defensively (some embedded
// preview contexts report 0) so the card never mis-positions.

const CARD_W = 340;

const viewport = () => ({
  vw: window.innerWidth || document.documentElement.clientWidth || 1024,
  vh: window.innerHeight || document.documentElement.clientHeight || 768,
});

export default function TourOverlay() {
  const { running, step, index, total, next, back, stop } = useTour();
  const [rect, setRect] = useState(null);

  const measure = useCallback(() => {
    if (!step || step.placement === 'center' || !step.selector) { setRect(null); return; }
    const el = document.querySelector(step.selector);
    if (!el) { setRect(null); return; }
    const r = el.getBoundingClientRect();
    const { vw, vh } = viewport();
    // Off-screen/hidden target (e.g. the off-canvas sidebar on mobile) → fall
    // back to a centered card rather than a spotlight pointing into the void.
    const visible = r.width > 0 && r.height > 0
      && r.left >= -1 && r.top >= -1 && r.left < vw && r.top < vh;
    setRect(visible ? r : null);
  }, [step]);

  useEffect(() => {
    if (!running) return undefined;
    // Defer the first measure to a frame (avoids a synchronous setState in the
    // effect, and lets a just-changed target finish laying out).
    const raf = requestAnimationFrame(measure);
    const t = setTimeout(measure, 140);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [running, measure]);

  if (!running || !step) return null;

  const pad = 8;
  const spot = rect
    ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    : null;

  // Position the card relative to the spotlight (or center it for intro / off-screen steps).
  let cardStyle;
  if (!spot) {
    cardStyle = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: CARD_W };
  } else {
    const { vw, vh } = viewport();
    const place = step.placement || 'bottom';
    let top = spot.top;
    let left;
    if (place === 'right') left = spot.left + spot.width + 16;
    else if (place === 'left') left = spot.left - CARD_W - 16;
    else { left = spot.left; top = spot.top + spot.height + 16; }
    // Keep the card on-screen.
    left = Math.max(16, Math.min(left, vw - CARD_W - 16));
    top = Math.max(16, Math.min(top, vh - 220));
    cardStyle = { top, left, width: CARD_W };
  }

  const isFirst = index === 0;
  const isLast = index === total - 1;

  return (
    <div className="pp-tour" role="dialog" aria-modal="true" aria-label="Guided tour">
      <div className="pp-tour-capture" />
      {spot ? (
        <div className="pp-tour-spotlight" style={spot} />
      ) : (
        <div className="pp-tour-dim" />
      )}
      <div className="pp-tour-card" style={cardStyle}>
        <div className="pp-tour-progress">Step {index + 1} of {total}</div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="pp-tour-actions">
          <button type="button" className="pp-link-muted" onClick={stop}>Skip</button>
          <div className="pp-tour-nav">
            {!isFirst && <button type="button" className="btn btn-outline btn-sm" onClick={back}>Back</button>}
            <button type="button" className="btn btn-primary btn-sm" onClick={next}>{isLast ? 'Done' : 'Next'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
