// A small SVG progress ring for the hub tiles: answered / total. Geometry (radius,
// stroke width, the dash length that draws the arc) is data, so it rides SVG attributes;
// every COLOUR comes from a CSS class (.review-ring-*), never a literal, so the ring
// re-skins with the theme like everything else (UI_RULES §121).
export default function ProgressRing({ done, total }) {
  const r = 15;
  const circ = 2 * Math.PI * r;
  const frac = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <svg className="review-ring" width="38" height="38" viewBox="0 0 38 38" aria-hidden="true">
      <circle className="review-ring-track" cx="19" cy="19" r={r} strokeWidth="5" fill="none" />
      {/* No arc when nothing is done — a round linecap on a zero-length dash would draw a
          stray dot at 12 o'clock on every empty tile. The full ring shows at 100%. */}
      {done > 0 && (
        <circle
          className="review-ring-fill"
          cx="19"
          cy="19"
          r={r}
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(circ * frac).toFixed(1)} ${circ.toFixed(1)}`}
          transform="rotate(-90 19 19)"
        />
      )}
      <text className="review-ring-num" x="19" y="23" textAnchor="middle">{done}/{total}</text>
    </svg>
  );
}
