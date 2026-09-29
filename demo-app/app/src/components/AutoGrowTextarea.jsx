import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// A textarea that grows DOWNWARD to fit its content instead of showing the native
// corner drag-handle (which let it expand past its container and clip over
// neighbours). It never caps its own height — when it outgrows its container the
// CONTAINER scrolls (in the New Job modal each column is its own scroll pane on
// desktop; on mobile the whole card scrolls). The `rows` prop is the starting /
// minimum height: resetting to height:auto before measuring keeps rows as the
// floor, so an empty field stays at its initial size and only grows past it.
export default function AutoGrowTextarea({ value, className = 'input', rows = 2, style, ...rest }) {
  const ref = useRef(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Reset first so the field can SHRINK back toward `rows`, not only grow.
    el.style.height = 'auto';
    // scrollHeight covers content + padding but not the border; add it back so a
    // 2px border can't clip the last line (overflow is hidden, so a shortfall
    // would silently cut text rather than show a scrollbar).
    const cs = getComputedStyle(el);
    const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    el.style.height = `${el.scrollHeight + border}px`;
  }, []);
  // Re-fit before paint on every value change (typing, programmatic reset, reopen)
  // so there's no flash of the wrong height.
  useLayoutEffect(() => { fit(); }, [value, fit]);
  // A width change (window / orientation) re-wraps the text, changing line count.
  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [fit]);
  return (
    <textarea
      ref={ref}
      className={className}
      rows={rows}
      value={value}
      // resize:none removes the native handle; overflow:hidden keeps the field
      // scrollbar-free while it grows (the container does the scrolling).
      style={{ boxSizing: 'border-box', overflow: 'hidden', resize: 'none', ...style }}
      {...rest}
    />
  );
}
