// Every page opens at its top; Back and Forward put you back where you were (CS-960, UI_RULES §186).
// lib/pageScroll.js decides where the page now on screen goes; this puts it there before its first
// frame is drawn, and keeps where each page was left.
//
// Mounted in both of AppLayout's shells, inside .main and BEFORE the page: its layout effect runs
// before the page's own effects, so the page is in its place on its first frame, and a page that
// moves itself after (a QR code's area on a checklist, CrewChecklist) still has the last word. The
// customer hub has its own shell and already opens each page at its top (measured 2026-11-02).
import { useEffect, useLayoutEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { placeFor, addressOf } from '../lib/pageScroll';

// One memory for the tab, so a shell mounted by a page change (the office's or a cleaner's) carries
// on from the last page. It lasts through a reload (saved as the page goes), as the browser's own did.
const MEMORY = 'cs.pageScroll.v1';
const KEEP = 100; // places per map: the newest
const places = { byKey: new Map(), byAddress: new Map() };
let here = null; // the page on screen (its location), null until the first page of a load
try {
  const saved = JSON.parse(sessionStorage.getItem(MEMORY) || 'null');
  for (const [key, y] of saved?.byKey || []) places.byKey.set(key, y);
  for (const [address, y] of saved?.byAddress || []) places.byAddress.set(address, y);
} catch { /* nothing saved, or no storage */ }

function remember() {
  try {
    sessionStorage.setItem(MEMORY, JSON.stringify({ byKey: [...places.byKey].slice(-KEEP), byAddress: [...places.byAddress].slice(-KEEP) }));
  } catch { /* full or blocked: the places last until the page goes */ }
}

// The box the page scrolls in: .main while it scrolls (a phone: the shell scrolls inside itself,
// UI_RULES §106), the document otherwise (a computer).
function pageScroller() {
  const main = document.querySelector('main.main');
  return main && /auto|scroll/.test(getComputedStyle(main).overflowY) ? main : (document.scrollingElement || document.documentElement);
}

// A page put back where it was can be shorter than that on its first frame and grow after it (a
// server read: on a computer the Customers list's ticket flags widen its Status column and its rows
// grow), and the browser's scroll anchoring would then move it. So for a moment it keeps to its
// place: anchoring off, snapped each frame it is short of it, until HOLD_MS have gone or the person
// scrolls, taps or types. A page at its top needs none: nothing moves a page at its top.
const HOLD_MS = 1000;
const HANDS = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
let hold = null; // the page being kept to its place: its box, its frame, its own overflow-anchor
function letGo() {
  if (!hold) return;
  cancelAnimationFrame(hold.frame);
  for (const ev of HANDS) window.removeEventListener(ev, letGo, true);
  hold.box.style.overflowAnchor = hold.anchor;
  hold = null;
}

// `instant`: html scrolls smoothly (index.css), and a page must not glide in from the last page's place.
function placePage(y) {
  letGo();
  const box = pageScroller();
  box.scrollTo({ top: y, behavior: 'instant' });
  if (!y) return;
  const until = performance.now() + HOLD_MS;
  const keepTo = () => {
    if (performance.now() > until) { letGo(); return; }
    if (Math.abs(box.scrollTop - y) > 1) box.scrollTo({ top: y, behavior: 'instant' });
    hold.frame = requestAnimationFrame(keepTo);
  };
  hold = { box, anchor: box.style.overflowAnchor, frame: requestAnimationFrame(keepTo) };
  box.style.overflowAnchor = 'none';
  for (const ev of HANDS) window.addEventListener(ev, letGo, { capture: true, passive: true });
}

export default function PageScroll() {
  const location = useLocation();
  const how = useNavigationType();

  // Before the frame is drawn.
  useLayoutEffect(() => {
    const was = here;
    here = location;
    const y = placeFor(was, location, how, places);
    if (y != null) placePage(y);
  }, [location, how]);

  // Where each page was left, from the scroll of .main (a phone) and of the window (a computer), by
  // history entry and by address, newest last. The browser's own restore is off while this runs: on
  // Back it would move the page still on screen to the next one's place before that page is drawn.
  // It is the browser's again when the page goes (a reload, another site) or this unmounts, and this
  // takes it back when the page returns from the back-forward cache.
  useEffect(() => {
    const browserRestores = (on) => { if ('scrollRestoration' in window.history) window.history.scrollRestoration = on ? 'auto' : 'manual'; };
    const main = document.querySelector('main.main');
    const keep = () => {
      if (!here) return;
      const y = Math.round(pageScroller().scrollTop);
      const address = addressOf(here);
      places.byKey.delete(here.key);
      places.byKey.set(here.key, y);
      places.byAddress.delete(address);
      places.byAddress.set(address, y);
    };
    const leave = () => { remember(); browserRestores(true); };
    const back = () => browserRestores(false);
    browserRestores(false);
    main?.addEventListener('scroll', keep, { passive: true });
    window.addEventListener('scroll', keep, { passive: true });
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', back);
    return () => {
      main?.removeEventListener('scroll', keep);
      window.removeEventListener('scroll', keep);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', back);
      letGo();
      browserRestores(true);
    };
  }, []);

  return null;
}
