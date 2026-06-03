import { PALETTES, PALETTE_KEYS, themeLabel } from '../brandTheme';
import DashboardPreview from '../preview/DashboardPreview';
import '../demo.css';

// Checkout brand-style selector. A toggle of the brand styles + a PERSISTENT
// dashboard preview (desktop + mobile device frames) that re-themes as the toggle
// changes — so the client sees exactly what their platform looks like in each
// brand. It does NOT reskin the checkout itself. Controlled by CheckoutPage;
// PolishPoint (Blue) is the default.

export default function CheckoutThemeSelect({ value, onChange }) {
  return (
    <section className="pp-deploy-theme">
      <div className="pp-deploy-theme-text">
        <h3>Your platform, in your brand colors</h3>
        <p>
          Your live platform is set up in your company’s brand colors. Pick the style closest to your
          brand — or keep the PolishPoint default — and see exactly how the dashboard looks.
        </p>
      </div>

      <div className="pp-deploy-tiles" role="radiogroup" aria-label="Brand style for your platform">
        {PALETTE_KEYS.map((key) => {
          const p = PALETTES[key];
          const selected = value === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`pp-deploy-tile${selected ? ' is-selected' : ''}`}
              onClick={() => onChange(key)}
              title={themeLabel(key)}
            >
              <span className="pp-deploy-tile-swatch" style={{ background: p.grad }} aria-hidden="true" />
              <span className="pp-deploy-tile-label">{themeLabel(key)}</span>
            </button>
          );
        })}
      </div>

      <DashboardPreview themeKey={value} />
    </section>
  );
}
