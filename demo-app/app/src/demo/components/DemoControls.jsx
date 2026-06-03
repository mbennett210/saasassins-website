import { useState } from 'react';
import { PALETTES, PALETTE_KEYS, applyPalette, saveBrand, loadBrand } from '../brandTheme';
import { useTour } from '../tour/tourContext';
import { resetDemo } from '../resetDemo';
import '../demo.css';

// Floating demo control, mounted in the live CRM only (AppLayout, behind IS_DEMO).
// A toggle opens a small panel to preview the product in different brand colors
// (live, global, persisted), replay the guided tour, or reset the sandbox. The
// guided tour spotlights this control (data-tour="theme").

export default function DemoControls() {
  const tour = useTour();
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(loadBrand().palette || 'blue');

  const pick = (key) => {
    setPalette(key);
    applyPalette(key);
    saveBrand({ palette: key });
  };

  return (
    <div className="pp-demo-controls" data-tour="theme">
      {open && (
        <div className="pp-demo-controls-panel">
          <div className="pp-demo-controls-row">
            <span className="pp-demo-controls-label">Brand colors</span>
            <div className="pp-demo-controls-swatches">
              {PALETTE_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`pp-swatch${palette === key ? ' is-active' : ''}`}
                  style={{ '--swatch': PALETTES[key].swatch }}
                  onClick={() => pick(key)}
                  aria-label={PALETTES[key].label}
                  aria-pressed={palette === key}
                  title={PALETTES[key].label}
                />
              ))}
            </div>
          </div>
          <div className="pp-demo-controls-actions">
            <button type="button" className="pp-link-muted" onClick={() => { setOpen(false); tour.start(); }}>Take the tour</button>
            <button type="button" className="pp-link-muted" onClick={resetDemo}>Reset demo</button>
          </div>
        </div>
      )}
      <button
        type="button"
        className="pp-demo-controls-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span aria-hidden="true">🎨</span> Demo
      </button>
    </div>
  );
}
