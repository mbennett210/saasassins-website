import { PALETTES, PALETTE_KEYS, themeLabel } from '../brandTheme';
import '../demo.css';

// Checkout brand-style selector. Unlike the in-demo live switcher, this does NOT
// reskin the checkout — it shows small example tiles (each rendered in that
// theme's own colors) so the client confirms which brand style their deployment
// ships in. Controlled by CheckoutPage; PolishPoint (Blue) is the default.

export default function CheckoutThemeSelect({ value, onChange }) {
  return (
    <section className="pp-deploy-theme">
      <div className="pp-deploy-theme-text">
        <h3>Your platform, in your brand colors</h3>
        <p>
          Your live platform is set up in your company’s brand colors. These are examples — pick the
          style closest to your brand, or keep the PolishPoint default.
        </p>
      </div>
      <div className="pp-deploy-tiles" role="radiogroup" aria-label="Brand theme for your platform">
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
              style={{
                '--tile-bg': p.preview.bg,
                '--tile-surface': p.preview.surface,
                '--tile-primary': p.preview.primary,
                '--tile-text': p.preview.text,
              }}
            >
              <span className="pp-deploy-tile-preview" aria-hidden="true">
                <span className="pp-deploy-tile-bar" />
                <span className="pp-deploy-tile-body">
                  <span className="pp-deploy-tile-chip" />
                  <span className="pp-deploy-tile-line" />
                  <span className="pp-deploy-tile-line short" />
                </span>
              </span>
              <span className="pp-deploy-tile-label">{themeLabel(key)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
