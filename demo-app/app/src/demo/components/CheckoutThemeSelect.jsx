import { useState } from 'react';
import { PALETTES, PALETTE_KEYS, themeLabel, isPaired, resolveThemeKey, loadBrand, saveBrand } from '../brandTheme';
import DashboardPreview from '../preview/DashboardPreview';
import '../demo.css';
import './checkoutThemeSelect.css';
import '../preview/miniAppGold.css';

// Checkout brand-style selector. A toggle of the brand styles + a PERSISTENT
// dashboard preview (desktop + mobile device frames) that re-themes as the toggle
// changes — so the client sees exactly what their platform looks like in each
// brand. It does NOT reskin the checkout itself. Controlled by CheckoutPage;
// PolishPoint (Blue) is the default.
//
// PAIRED brands (Midnight) additionally expose a light/dark mode toggle: the
// brand ships in both a dark variant (Midnight Luxe) and a light one (Daylight
// Gilt). The mode resolves to the themeEngine base via resolveThemeKey() and is
// persisted as `midnightMode` so the prospect's choice survives a reload. Mode
// is local to this selector (the brand KEY is the deployment id sent to checkout);
// the toggle is purely about showing both variants exist.

export default function CheckoutThemeSelect({ value, onChange }) {
  const [mode, setMode] = useState(() => (loadBrand().midnightMode === 'light' ? 'light' : 'dark'));
  const chooseMode = (m) => { setMode(m); saveBrand({ midnightMode: m }); };
  const previewKey = resolveThemeKey(value, mode);

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
              {isPaired(key) && <span className="pp-deploy-tile-pair">Light + Dark</span>}
            </button>
          );
        })}
      </div>

      {/* Light/dark mode toggle — only for paired brands (Midnight). Lets the
          prospect flip between Midnight Luxe (dark) and Daylight Gilt (light). */}
      {isPaired(value) && (
        <div className="pp-mode-row">
          <span className="pp-mode-label">{themeLabel(value)} comes in light &amp; dark — preview either:</span>
          <div className="pp-mode-seg" role="group" aria-label="Light or dark variant">
            <button
              type="button"
              className={mode === 'dark' ? 'is-on' : ''}
              aria-pressed={mode === 'dark'}
              onClick={() => chooseMode('dark')}
            >
              ☾ Dark
            </button>
            <button
              type="button"
              className={mode === 'light' ? 'is-on' : ''}
              aria-pressed={mode === 'light'}
              onClick={() => chooseMode('light')}
            >
              ☀ Light
            </button>
          </div>
        </div>
      )}

      <DashboardPreview themeKey={previewKey} />
    </section>
  );
}
