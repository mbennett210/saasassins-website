// escapeLayers — the ONE Escape for everything that floats over the page (UI_RULES §181,
// task #265).
//
// The bug it fixes: each layer had its own keydown listener. A popup (Modal) listened on the
// window, and a dropdown inside it (PopMenu, through useDismissTap) listened on the window too,
// added LATER — so the popup's listener ran first and Esc closed the whole popup, and everything
// typed into it, when it was meant for the dropdown. (The dropdown's `stopPropagation` could not
// help: it stops nothing on the target the event is already at.) A phone sheet listened on the
// document and did not stop the key at all, so a sheet over a popup closed both.
//
// So every layer joins ONE stack while it is open — a popup (Modal), a phone sheet
// (MobileSheet), an anchored menu or dropdown (useDismissTap, so PopMenu and every picker on
// it), the messages dock — and ONE listener closes only the NEWEST. A dropdown opened inside a
// popup is newer than the popup, so Esc closes the dropdown and leaves the popup as it was; the
// next Esc closes the popup.
//
// A field that handles Escape itself (a picker's search box closing its list, an inline editor
// reverting its text) calls `e.preventDefault()`, and then no layer closes: the field takes Esc
// first. The listener is on the window in the bubble phase, so a field's own handler (React's,
// on the root or on a portal's container) has always run by then. Once a layer has taken the
// key it calls `preventDefault()` too, so any other listener can tell Esc is spent.
//
// Plain JS, no React: the hook is hooks/useEscapeLayer.js; scripts/test-escape-layers.mjs runs
// this file under node.

const layers = [];

function onKeyDown(e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const top = layers[layers.length - 1];
  if (!top) return;
  e.preventDefault();
  top.close();
}

// Join the stack; returns the function that leaves it. `close` runs when Esc reaches this layer
// while it is the newest.
export function addEscapeLayer(close) {
  const layer = { close };
  if (layers.length === 0) window.addEventListener('keydown', onKeyDown);
  layers.push(layer);
  return () => {
    const i = layers.indexOf(layer);
    if (i !== -1) layers.splice(i, 1);
    if (layers.length === 0) window.removeEventListener('keydown', onKeyDown);
  };
}

// How many layers are open (for the test).
export function escapeLayerCount() {
  return layers.length;
}
