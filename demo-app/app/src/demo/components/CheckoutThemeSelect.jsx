import { useState } from 'react';
import { PALETTES, PALETTE_KEYS, themeLabel } from '../brandTheme';
import ThemePreviewModal from './ThemePreviewModal';
import '../demo.css';

// Checkout brand-style selector. The client picks a style and can preview an
// abbreviated, themed dashboard (in desktop + phone device frames) to see what
// their platform looks like in that brand. It does NOT reskin the checkout — the
// demo stays in the clean PolishPoint look. Controlled by CheckoutPage;
// PolishPoint (Blue) is the default.

export default function CheckoutThemeSelect({ value, onChange }) {
  const [previewing, setPreviewing] = useState(false);

  return (
    <section className="pp-deploy-theme">
      <div className="pp-deploy-theme-text">
        <h3>Your platform, in your brand colors</h3>
        <p>
          Your live platform is set up in your company’s brand colors. Pick the style closest to
          your brand — or keep the PolishPoint default — and preview how the dashboard looks.
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
              <span className="pp-deploy-tile-swatch" style={{ background: p.t.grad }} aria-hidden="true" />
              <span className="pp-deploy-tile-label">{themeLabel(key)}</span>
            </button>
          );
        })}
      </div>

      <button type="button" className="btn btn-outline pp-deploy-preview-btn" onClick={() => setPreviewing(true)}>
        👁  Preview your dashboard
      </button>

      {previewing && (
        <ThemePreviewModal value={value} onChange={onChange} onClose={() => setPreviewing(false)} />
      )}
    </section>
  );
}
