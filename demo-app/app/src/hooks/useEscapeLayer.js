import { useEffect, useRef } from 'react';
import { addEscapeLayer } from '../lib/escapeLayers';

// useEscapeLayer — while `open`, this layer is on the one Escape stack (lib/escapeLayers,
// UI_RULES §181): Esc calls `onEscape` only when this is the newest open layer, and never when a
// field inside it took the key first (`e.preventDefault()`).
//
// `onEscape` may be an inline arrow: it is read through a ref, so the layer keeps its place in
// the stack across renders (re-joining would move it on top of a dropdown opened inside it).
export function useEscapeLayer(open, onEscape) {
  const cb = useRef(onEscape);
  useEffect(() => {
    cb.current = onEscape;
  });
  useEffect(() => {
    if (!open) return undefined;
    return addEscapeLayer(() => cb.current?.());
  }, [open]);
}

export default useEscapeLayer;
