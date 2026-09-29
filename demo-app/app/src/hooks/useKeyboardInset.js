import { useEffect } from 'react';
import { measureKeyboard } from '../lib/keyboardInset';

// useKeyboardInset(ref, active) — while `active`, publishes the on-screen keyboard's
// footprint on ref's element: `--kb-inset` (px of the layout viewport hidden below the
// visible band), `--vv-top` (how far iOS panned the visual viewport down) and
// `data-kb="up|down"`.
//
// iOS Safari / the installed PWA (and Android Chrome) raise the keyboard by shrinking only
// the VISUAL viewport, which position:fixed ignores, so a fixed full-screen surface has its
// bottom rows stranded behind the keyboard. A surface pads its scroller by `--kb-inset` so
// every row stays reachable above it. Written imperatively (never React state), so keyboard
// motion never re-renders. The math is pure and node-tested (lib/keyboardInset.js).
export function useKeyboardInset(ref, active) {
  useEffect(() => {
    if (!active) return undefined;
    const vv = window.visualViewport;
    const el = ref.current;
    if (!vv || !el) return undefined;
    const apply = () => {
      const { top, hidden, raised } = measureKeyboard(window.innerHeight, vv.height, vv.offsetTop);
      el.style.setProperty('--vv-top', `${top}px`);
      el.style.setProperty('--kb-inset', `${hidden}px`);
      el.dataset.kb = raised ? 'up' : 'down';
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
    };
  }, [ref, active]);
}
