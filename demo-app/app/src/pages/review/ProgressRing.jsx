// A small SVG progress ring for the hub tiles: answered / total. Geometry (radius,
// stroke width, the dash length that draws the arc) is data, so it rides SVG attributes;
// every COLOUR comes from a CSS class (.review-ring-*), never a literal, so the ring
// re-skins with the theme like everything else (UI_RULES §121).
//
// The label sits INSIDE the ring, so the ring is sized for it. The old 38px ring with a
// 5px stroke left 25px clear, and any two-digit pair ("14/14", "39/39") ran into the
// stroke. 48px with a 4px stroke leaves 39px; a five-character label fits at the 10px
// bold token with room to spare. Anything longer ("153/153") is squeezed to the clear
// width with textLength, so no count can ever cross the stroke.
//
// `label` stands in for "done/total" and `tone="warn"` draws the arc amber: the Waiting on us tile
// (CS-864) is a full amber ring around its own count.
const SIZE = 48;
const STROKE = 4;
const R = (SIZE - STROKE) / 2 - 0.5; // 0.5px inside the box so the round cap never clips
const C = SIZE / 2;
const RING_CLEAR = 2 * (R - STROKE / 2) - 6; // the label's widest allowed run, 3px off the stroke each side
const RING_FITS_CHARS = 5;

export default function ProgressRing({ done, total, label: shownLabel, tone }) {
  const circ = 2 * Math.PI * R;
  const frac = total > 0 ? Math.min(1, done / total) : 0;
  const label = shownLabel ?? `${done}/${total}`;
  const squeeze = label.length > RING_FITS_CHARS
    ? { textLength: RING_CLEAR, lengthAdjust: 'spacingAndGlyphs' }
    : {};
  return (
    <svg className="review-ring" width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
      <circle className="review-ring-track" cx={C} cy={C} r={R} strokeWidth={STROKE} fill="none" />
      {/* No arc when nothing is done — a round linecap on a zero-length dash would draw a
          stray dot at 12 o'clock on every empty tile. The full ring shows at 100%. */}
      {done > 0 && (
        <circle
          className={`review-ring-fill${tone === 'warn' ? ' is-warn' : ''}`}
          cx={C}
          cy={C}
          r={R}
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(circ * frac).toFixed(1)} ${circ.toFixed(1)}`}
          transform={`rotate(-90 ${C} ${C})`}
        />
      )}
      <text className="review-ring-num" x={C} y={C} textAnchor="middle" dominantBaseline="central" {...squeeze}>{label}</text>
    </svg>
  );
}
