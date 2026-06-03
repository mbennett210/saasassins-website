import { PALETTES, PALETTE_KEYS, themeLabel } from '../brandTheme';
import '../demo.css';

// Checkout brand-style selector. Shows faithful example images of each swatchboard
// (the real brand styles SaaSassins ships) so the client confirms which style
// their deployment is set up in. It does NOT reskin the checkout — the demo stays
// in the clean PolishPoint look. Controlled by CheckoutPage; PolishPoint (Blue)
// is the default.

export default function CheckoutThemeSelect({ value, onChange }) {
  return (
    <section className="pp-deploy-theme">
      <div className="pp-deploy-theme-text">
        <h3>Your platform, in your brand colors</h3>
        <p>
          Your live platform is set up in your company’s brand colors. These are examples of the
          brand styles we ship — pick the one closest to your brand, or keep the PolishPoint default.
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
              <img className="pp-deploy-tile-img" src={p.image} alt={`${themeLabel(key)} brand style example`} loading="lazy" />
              <span className="pp-deploy-tile-label">
                <span className="pp-deploy-tile-dot" style={{ background: p.swatch }} aria-hidden="true" />
                {themeLabel(key)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
