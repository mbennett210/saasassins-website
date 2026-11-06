// Where a FLOATING menu goes (PopMenu `float`; CS-724) — PURE / node-safe, so the suite reads the
// one rule the component uses.
//
// A picker inside something that clips — a table row, whose .table-wrap scrolls sideways
// (overflow-x auto, which makes overflow-y hidden) — cannot hang its menu below itself: on a
// bottom row the table cuts it off. PopMenu draws such a menu through a portal in fixed position,
// and this decides where: BELOW the trigger when the whole menu fits there, else on the side with
// more room (above, for a bottom row near the screen's foot), shrunk to that room; as wide as the
// trigger but at least FLOAT_MIN_WIDTH, and never past the screen's edge.

// The menu's own max-height: .select-menu in index.css (the suite holds the two equal).
export const FLOAT_MENU_MAX = 280;
// Its gap off the trigger and off the screen's edge.
export const FLOAT_GAP = 4;
// A trigger in a table cell can be narrow; a menu of names needs about this much.
export const FLOAT_MIN_WIDTH = 224;

// `rect`: the trigger's box ({ top, bottom, left, width }, viewport coordinates).
// `viewport`: the window's { width, height }.
// Returns { up, left, width, top, bottom, maxHeight } — `top` is null when it opens upward (then
// `bottom` is its distance from the viewport's foot), and `bottom` is null when it opens downward.
export function floatPlacement(rect, viewport, { maxHeight = FLOAT_MENU_MAX, gap = FLOAT_GAP, minWidth = FLOAT_MIN_WIDTH } = {}) {
  const below = viewport.height - rect.bottom - gap * 2;
  const above = rect.top - gap * 2;
  const up = below < maxHeight && above > below;
  const width = Math.min(Math.max(rect.width, minWidth), viewport.width - gap * 2);
  const left = Math.max(gap, Math.min(rect.left, viewport.width - width - gap));
  return {
    up,
    left,
    width,
    top: up ? null : rect.bottom + gap,
    bottom: up ? viewport.height - rect.top + gap : null,
    maxHeight: Math.max(0, Math.min(maxHeight, up ? above : below)),
  };
}
