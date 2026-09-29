// keyboardInset.js — how much of the LAYOUT viewport an on-screen keyboard hides.
// ZERO imports: pure math, node-tested (scripts/test-keyboard-inset.mjs).
//
// iOS Safari / the installed PWA (and Android Chrome since 108) raise the keyboard by
// shrinking only the VISUAL viewport. `position: fixed` stays sized to the layout viewport,
// so the bottom of a fixed surface ends up behind the keyboard unless it reads
// `window.visualViewport` and pads or lifts itself (hooks/useKeyboardInset). Given the layout height (innerHeight) and the
// visual viewport's height + offsetTop (iOS may also pan the visual viewport down), this
// returns the visible band's top and how much is hidden BELOW it.

// Anything smaller than this is browser chrome (a URL bar / toolbar settling), not a
// keyboard: the smallest phone keyboard is ~260px.
export const KEYBOARD_MIN = 120;

export function measureKeyboard(innerHeight, vvHeight, vvOffsetTop) {
  const inner = Number.isFinite(innerHeight) && innerHeight > 0 ? innerHeight : 0;
  const top = Math.max(0, Math.round(Number.isFinite(vvOffsetTop) ? vvOffsetTop : 0));
  const visible = Number.isFinite(vvHeight) && vvHeight > 0 ? vvHeight : inner - top;
  const hidden = Math.max(0, Math.round(inner - top - visible));
  return { top, hidden, raised: hidden >= KEYBOARD_MIN };
}
