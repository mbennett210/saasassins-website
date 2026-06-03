import { useState, useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { TOUR_STEPS } from './tourSteps';
import { TourCtx } from './tourContext';

// Guided-tour controller (demo only). Tracks the current step, exposes
// start/next/back/stop, and auto-starts once the first time a prospect lands in
// the live CRM (not on the standalone /demo or /checkout surfaces). "Seen" is
// remembered in localStorage so it never nags; resetDemo() clears it.

const SEEN_KEY = 'pp.demo.tourSeen.v1';

const wasSeen = () => {
  try { return window.localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
};
const markSeen = () => {
  try { window.localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore */ }
};

export function TourProvider({ children }) {
  const [index, setIndex] = useState(-1); // -1 = not running
  const { pathname } = useLocation();
  const autoStarted = useRef(false);

  const start = useCallback(() => setIndex(0), []);
  const stop = useCallback(() => { markSeen(); setIndex(-1); }, []);
  const next = useCallback(() => setIndex((i) => {
    if (i + 1 >= TOUR_STEPS.length) { markSeen(); return -1; }
    return i + 1;
  }), []);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // Auto-start once, the first time the prospect is on a live-CRM route.
  useEffect(() => {
    if (autoStarted.current || wasSeen()) return undefined;
    const isCrm = !pathname.startsWith('/demo') && !pathname.startsWith('/checkout');
    if (!isCrm) return undefined;
    // Flip the guard inside the timer (not before) so React StrictMode's
    // setup→cleanup→setup double-invoke doesn't clear the timer and then skip
    // re-arming it.
    const t = setTimeout(() => { autoStarted.current = true; setIndex(0); }, 700);
    return () => clearTimeout(t);
  }, [pathname]);

  const running = index >= 0;
  const value = {
    running,
    index,
    step: running ? TOUR_STEPS[index] : null,
    total: TOUR_STEPS.length,
    start,
    stop,
    next,
    back,
  };

  return <TourCtx.Provider value={value}>{children}</TourCtx.Provider>;
}
