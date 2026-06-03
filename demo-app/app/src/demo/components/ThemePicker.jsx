import { useState } from 'react';
import { PALETTES, PALETTE_KEYS, applyPalette, saveBrand, loadBrand } from '../brandTheme';
import '../demo.css';

// Brand-theme picker shown at checkout (demo only). Offers the swatchboard-derived
// palettes SaaSassins ships; picking one previews it live across the demo + CRM and
// persists the choice. Defaults to Blue (the PolishPoint baseline). Reset demo
// reverts it.

export default function ThemePicker() {
  const [palette, setPalette] = useState(loadBrand().palette || 'blue');

  const pick = (key) => {
    setPalette(key);
    applyPalette(key);
    saveBrand({ palette: key });
  };

  return (
    <section className="pp-theme-picker">
      <div className="pp-theme-picker-text">
        <h3>Pick your brand theme</h3>
        <p>Choose the look your platform ships with — preview it live across the demo, change it anytime.</p>
      </div>
      <div className="pp-theme-picker-swatches" role="group" aria-label="Brand theme">
        {PALETTE_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={`pp-theme-opt${palette === key ? ' is-active' : ''}`}
            onClick={() => pick(key)}
            aria-pressed={palette === key}
            title={PALETTES[key].label}
          >
            <span className="pp-swatch" style={{ '--swatch': PALETTES[key].swatch }} aria-hidden="true" />
            <span className="pp-theme-opt-label">{PALETTES[key].label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
